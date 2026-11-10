/**
 * The layout tree's ids for preview tiles (preview-tile.tsx): one pane per
 * preview tab, `preview-tile:<tab id>`. Its own module so chrome that shows
 * whether a tab is on screen (the titlebar's 剪辑, hc-1201) names the same
 * pane without loading the tile itself.
 */

export const PREVIEW_TILE_PREFIX = 'preview-tile'

export const previewPaneId = (tabId: string) => `${PREVIEW_TILE_PREFIX}:${tabId}`
