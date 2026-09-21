if (typeof window !== "undefined" && typeof Document !== "undefined") {
  // Obsidian supplies these DOM helpers in every window; jsdom does not.
  Object.defineProperty(Document.prototype, "win", {
    get() {
      return this.defaultView;
    },
  });
  window.createEl = (tag, options) => {
    const element = document.createElement(tag);
    if (typeof options === "string") element.className = options;
    else if (options) {
      if (options.cls)
        element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
      if (typeof options.text === "string") element.textContent = options.text;
      else if (options.text) element.append(options.text);
    }
    return element;
  };
  window.createSpan = (options) => window.createEl("span", options);
}
