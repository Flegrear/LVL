// A native file picker completes asynchronously, after other menus may have
// changed their current selection. Bind the action to its original target.
export function createPendingSelection() {
  let selected = null;
  return {
    begin(value) {
      selected = typeof value === "string" && value ? value : null;
      return selected !== null;
    },
    take() {
      const value = selected;
      selected = null;
      return value;
    },
    cancel() { selected = null; },
  };
}
