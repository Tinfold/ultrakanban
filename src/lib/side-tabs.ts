/** The ids of a side tab and its panel (see `SideTabs`), so the panel can point back at its tab. */
export const sideTabIds = (prefix: string, id: string) => ({
  tab: `${prefix}-tab-${id}`,
  panel: `${prefix}-panel-${id}`,
})
