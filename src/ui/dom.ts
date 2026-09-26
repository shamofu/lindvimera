/** Create in the container's window, including Obsidian's detached settings windows. */
export function child<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const ownerWindow = parent.ownerDocument.win as Window & { createEl: typeof createEl };
  const element = ownerWindow.createEl(tag, { cls: className, text });
  parent.append(element);
  return element;
}
