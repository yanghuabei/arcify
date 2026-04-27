/**
 * arc-import.js - Arc Browser Space JSON Import Utility
 *
 * Purpose: Parses Arc browser's StorageV2.json and imports spaces/bookmarks into Arcify
 * Key Functions: JSON parsing, space creation, bookmark creation
 * Architecture: Stateless utility functions for parsing and importing Arc data
 *
 * Supported Formats:
 * 1. Arc StorageV2.json (sidebar.sidebarSyncState with items array and spaces array)
 * 2. Simple format ({ spaces: [{ name, items: [{ title, url, isPinned }] }] })
 */

import { LocalStorage } from './localstorage.js';
import { Logger } from './logger.js';

/**
 * Normalized item structure:
 * { type: 'tab'|'folder', title: string, url?: string, isPinned?: boolean, children?: NormalizedItem[] }
 */

/**
 * Parse Arc JSON string or object into a normalized list of spaces.
 * @param {string|object} input - Raw Arc JSON string or already-parsed object
 * @returns {{ spaces: Array<{ name: string, items: NormalizedItem[] }> }}
 */
export function parseArcJSON(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;

    // Format 1: Arc StorageV2 - sidebar.sidebarSyncState
    if (data?.sidebar?.sidebarSyncState) {
        return parseStorageV2Format(data.sidebar.sidebarSyncState);
    }

    // Format 2: Top-level sidebarSyncState
    if (data?.sidebarSyncState) {
        return parseStorageV2Format(data.sidebarSyncState);
    }

    // Format 3: Simple { spaces: [...] }
    if (Array.isArray(data?.spaces)) {
        return parseSimpleFormat(data);
    }

    // Format 4: Single space as top-level { name, items }
    if (data?.items && (data?.name || data?.title)) {
        return { spaces: [parseSimpleSpace(data)] };
    }

    throw new Error('Unrecognized Arc JSON format. Please export from Arc > Settings and select the StorageV2.json file.');
}

/**
 * Parse Arc StorageV2 sidebarSyncState format.
 * @param {object} state - The sidebarSyncState object
 */
function parseStorageV2Format(state) {
    const rawItems = state.items;
    const rawSpaces = state.spaces;

    if (!rawItems || !rawSpaces) {
        throw new Error('Invalid StorageV2 format: missing "items" or "spaces" in sidebarSyncState.');
    }

    // Build a lookup map: id -> item (support both array and object/dict)
    const itemMap = {};
    if (Array.isArray(rawItems)) {
        rawItems.forEach(item => {
            if (item?.id) itemMap[item.id] = item;
        });
    } else if (typeof rawItems === 'object') {
        Object.assign(itemMap, rawItems);
    }

    // Parse spaces (support both array and object/dict)
    const spacesArray = Array.isArray(rawSpaces)
        ? rawSpaces
        : Object.values(rawSpaces);

    const spaces = spacesArray
        .map(space => parseStorageV2Space(space, itemMap))
        .filter(Boolean);

    return { spaces };
}

/**
 * Parse a single space from StorageV2 format.
 */
function parseStorageV2Space(space, itemMap) {
    const name = space.title || space.name || 'Imported Space';
    const containerIDs = space.containerIDs || space.itemIDs || [];

    const items = containerIDs
        .map(id => resolveStorageV2Item(id, itemMap))
        .filter(Boolean);

    return { name, items };
}

/**
 * Recursively resolve a StorageV2 item by ID.
 */
function resolveStorageV2Item(id, itemMap) {
    const item = itemMap[id];
    if (!item) return null;

    const data = item.data || item;

    // Tab item
    if (data.tab) {
        const tab = data.tab;
        const url = tab.savedURL || tab.url;
        if (!url) return null;
        return {
            type: 'tab',
            title: tab.savedTitle || tab.title || url,
            url,
            isPinned: tab.isPinned ?? true, // default to true (pinned) when field is absent
        };
    }

    // Folder/list item
    if (data.list || data.folder) {
        const folder = data.list || data.folder;
        const childrenIds = item.childrenIds || item.children || [];
        const children = (Array.isArray(childrenIds) ? childrenIds : [])
            .map(childId => resolveStorageV2Item(childId, itemMap))
            .filter(Boolean);
        return {
            type: 'folder',
            title: folder.name || folder.title || 'Untitled Folder',
            children,
        };
    }

    // Fallback: try treating the item itself as a tab
    const url = item.savedURL || item.url;
    if (url) {
        return {
            type: 'tab',
            title: item.savedTitle || item.title || url,
            url,
            isPinned: item.isPinned ?? true,
        };
    }

    return null;
}

/**
 * Parse the simple format: { spaces: [{ name, items: [...] }] }
 */
function parseSimpleFormat(data) {
    const spaces = data.spaces.map(parseSimpleSpace).filter(Boolean);
    return { spaces };
}

/**
 * Parse a single space from the simple format.
 */
function parseSimpleSpace(space) {
    const name = space.name || space.title || 'Imported Space';
    const rawItems = space.items || space.sidebarItems || space.tabs || [];
    const items = rawItems.map(parseSimpleItem).filter(Boolean);
    return { name, items };
}

/**
 * Parse a single item from the simple format.
 */
function parseSimpleItem(item) {
    if (!item) return null;

    const type = item.type || (item.items || item.children ? 'folder' : 'tab');

    if (type === 'folder') {
        const children = (item.items || item.children || []).map(parseSimpleItem).filter(Boolean);
        return {
            type: 'folder',
            title: item.title || item.name || 'Untitled Folder',
            children,
        };
    }

    // Tab item
    const url = item.url || item.savedURL;
    if (!url) return null;
    return {
        type: 'tab',
        title: item.title || item.savedTitle || url,
        url,
        isPinned: item.isPinned ?? true,
    };
}

/**
 * Import parsed Arc spaces into Arcify's Chrome bookmark structure.
 * Only imports pinned tabs and folders by default.
 *
 * @param {{ spaces: Array<{ name: string, items: NormalizedItem[] }> }} parsed
 * @param {{ includePinnedOnly: boolean, onProgress: function }} options
 * @returns {Promise<{ imported: number, skipped: number, errors: string[] }>}
 */
export async function importArcSpaces(parsed, options = {}) {
    const { includePinnedOnly = true, onProgress = null } = options;
    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const space of parsed.spaces) {
        try {
            Logger.log('[ArcImport] Importing space:', space.name);
            if (onProgress) onProgress(`Importing space: ${space.name}…`);

            const spaceFolder = await LocalStorage.getOrCreateSpaceFolder(space.name);

            const result = await importItemsIntoFolder(
                space.items,
                spaceFolder.id,
                includePinnedOnly
            );
            imported += result.imported;
            skipped += result.skipped;
        } catch (err) {
            const msg = `Failed to import space "${space.name}": ${err.message}`;
            Logger.error('[ArcImport]', msg);
            errors.push(msg);
        }
    }

    return { imported, skipped, errors };
}

/**
 * Recursively import items into a bookmark folder.
 * @param {NormalizedItem[]} items
 * @param {string} parentId - Chrome bookmark folder ID
 * @param {boolean} includePinnedOnly
 */
async function importItemsIntoFolder(items, parentId, includePinnedOnly) {
    let imported = 0;
    let skipped = 0;

    // Get existing bookmarks to avoid duplicates
    const existingChildren = await chrome.bookmarks.getChildren(parentId);
    const existingUrls = new Set(existingChildren.filter(c => c.url).map(c => c.url));
    const existingFolderNames = new Set(existingChildren.filter(c => !c.url).map(c => c.title));

    for (const item of items) {
        if (item.type === 'tab') {
            // Skip unpinned tabs if includePinnedOnly is set
            if (includePinnedOnly && item.isPinned === false) {
                skipped++;
                continue;
            }
            if (!item.url) {
                skipped++;
                continue;
            }
            // Skip duplicates
            if (existingUrls.has(item.url)) {
                skipped++;
                continue;
            }
            try {
                await chrome.bookmarks.create({
                    parentId,
                    title: item.title || item.url,
                    url: item.url,
                });
                existingUrls.add(item.url);
                imported++;
                Logger.log('[ArcImport] Created bookmark:', item.title, item.url);
            } catch (err) {
                Logger.error('[ArcImport] Failed to create bookmark:', item.title, err);
            }
        } else if (item.type === 'folder') {
            // Find or create sub-folder
            let subFolder = existingChildren.find(c => !c.url && c.title === item.title);
            if (!subFolder) {
                try {
                    subFolder = await chrome.bookmarks.create({
                        parentId,
                        title: item.title || 'Untitled Folder',
                    });
                    existingFolderNames.add(item.title);
                    Logger.log('[ArcImport] Created folder:', item.title);
                } catch (err) {
                    Logger.error('[ArcImport] Failed to create folder:', item.title, err);
                    continue;
                }
            }
            if (item.children?.length) {
                const result = await importItemsIntoFolder(item.children, subFolder.id, includePinnedOnly);
                imported += result.imported;
                skipped += result.skipped;
            }
        }
    }

    return { imported, skipped };
}
