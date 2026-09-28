// Native offline inventory is an all-or-nothing snapshot. Keep the Fuse index
// and its AsyncStorage envelope under this item-count ceiling; when a full sync
// reports more items, retain the last complete snapshot and show a warning.
// Page fetches stop at the first response reporting an oversized total (or
// before adding a page that would exceed the ceiling).
export const MAX_OFFLINE_INVENTORY_ITEMS = 5000;