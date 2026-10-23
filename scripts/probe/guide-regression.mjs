import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/** Exercise the real guide, including the native Electron window and scrollbar. */
export async function checkGuideScrolling(guide) {
  const page = guide.page();
  const results = guide.getByRole("region", { name: "操作一覧", exact: true });
  const search = guide.getByRole("searchbox", { name: "操作ガイドを検索", exact: true });
  const count = guide.getByRole("status");
  // Obsidian initializes this BrowserWindow handle in each native renderer.
  const nativeWindow = await page.evaluate(() => {
    const win = window.electronWindow;
    const methods = [
      "getBounds",
      "getNormalBounds",
      "getMinimumSize",
      "setBounds",
      "isMaximized",
      "isFullScreen",
      "unmaximize",
      "maximize",
      "setFullScreen",
    ];
    const missing = methods.filter((name) => typeof win?.[name] !== "function");
    if (missing.length) throw new Error(`Obsidian native window is missing: ${missing.join(", ")}`);
    return {
      bounds: win.getBounds(),
      normalBounds: win.getNormalBounds(),
      minimumSize: win.getMinimumSize(),
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    };
  });
  console.log("Guide native window:", JSON.stringify(nativeWindow));
  const theme = await page.evaluate(() => ({
    light: document.body.classList.contains("theme-light"),
    dark: document.body.classList.contains("theme-dark"),
  }));
  const observations = [];

  async function settled() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function waitForScroll(end = false) {
    const handle = await results.elementHandle();
    try {
      await page.waitForFunction(
        ({ element, end }) =>
          end
            ? Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 2
            : element.scrollTop > 2,
        { element: handle, end },
      );
    } finally {
      await handle.dispose();
    }
  }
  async function fixedControls(before, label) {
    const after = { search: await search.boundingBox(), count: await count.boundingBox() };
    for (const control of ["search", "count"]) {
      assert.ok(after[control], `${label}: ${control} remains visible.`);
      assert.ok(
        Math.abs(after[control].y - before[control].y) <= 1,
        `${label}: ${control} stays fixed.`,
      );
    }
    assert.equal(
      await guide.evaluate((el) => el.scrollTop),
      0,
      `${label}: the modal does not scroll.`,
    );
    assert.equal(
      await guide.locator(".lindvimera-guide-content").evaluate((el) => el.scrollTop),
      0,
      `${label}: the content wrapper does not scroll.`,
    );
  }
  async function exercise(label) {
    const layout = await results.evaluate((el) => {
      const style = getComputedStyle(el);
      const thumb = getComputedStyle(el, "::-webkit-scrollbar-thumb");
      const track = getComputedStyle(el, "::-webkit-scrollbar-track");
      const rect = el.getBoundingClientRect();
      const border = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      return {
        top: rect.top,
        bottom: rect.bottom,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        gutter: el.offsetWidth - el.clientWidth - border,
        overflowY: style.overflowY,
        thumb: thumb.backgroundColor,
        track: track.backgroundColor,
        minimumThumb: parseFloat(thumb.minHeight) || 0,
      };
    });
    const modal = await guide.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(modal, `${label}: the guide is visible.`);
    assert.ok(
      modal.y >= -1 && modal.y + modal.height <= viewport.height + 1,
      `${label}: modal fits vertically.`,
    );
    assert.ok(
      modal.x >= -1 && modal.x + modal.width <= viewport.width + 1,
      `${label}: modal fits horizontally.`,
    );
    assert.ok(
      layout.clientHeight > 40 && layout.scrollHeight > layout.clientHeight,
      `${label}: results overflow.`,
    );
    assert.equal(layout.overflowY, "scroll", `${label}: the results reserve a vertical scrollbar.`);
    assert.ok(layout.gutter >= 8, `${label}: the native scrollbar has a visible gutter.`);
    assert.ok(
      layout.bottom <= modal.y + modal.height + 1,
      `${label}: results stay within the modal.`,
    );
    assert.notEqual(layout.thumb, "rgba(0, 0, 0, 0)", `${label}: the scrollbar thumb is visible.`);
    assert.notEqual(layout.thumb, layout.track, `${label}: thumb contrasts with its track.`);
    const fixed = { search: await search.boundingBox(), count: await count.boundingBox() };
    assert.ok(fixed.search && fixed.count, `${label}: search and count are visible.`);
    assert.ok(
      fixed.count.y + fixed.count.height <= layout.top + 1,
      `${label}: count is above the results.`,
    );

    await results.evaluate((el) => {
      el.scrollTop = 0;
    });
    await results.hover();
    await page.mouse.wheel(0, 500);
    await waitForScroll();
    await fixedControls(fixed, `${label} wheel`);

    await results.evaluate((el) => {
      el.scrollTop = 0;
    });
    await search.focus();
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("Tab");
      if (await results.evaluate((el) => document.activeElement === el)) break;
    }
    assert.equal(
      await results.evaluate((el) => document.activeElement === el),
      true,
      `${label}: Tab reaches results.`,
    );
    await results.press("PageDown");
    await waitForScroll();
    await fixedControls(fixed, `${label} PageDown`);
    await results.press("End");
    await waitForScroll(true);
    await fixedControls(fixed, `${label} End`);

    await results.evaluate((el) => {
      el.scrollTop = 0;
    });
    await settled();
    const box = await results.boundingBox();
    assert.ok(box, `${label}: results have native scrollbar bounds.`);
    const thumbHeight = Math.max(
      layout.minimumThumb,
      layout.clientHeight ** 2 / layout.scrollHeight,
    );
    const x = box.x + box.width - layout.gutter / 2;
    const y = box.y + Math.min(thumbHeight / 2, layout.clientHeight / 3);
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x, Math.min(box.y + box.height - 8, y + 100), { steps: 8 });
    } finally {
      await page.mouse.up();
    }
    await waitForScroll();
    await fixedControls(fixed, `${label} scrollbar drag`);

    await search.fill("za");
    assert.equal(
      await results.evaluate((el) => el.scrollTop),
      0,
      `${label}: filtering resets results to the top.`,
    );
    await search.fill("");
    await guide.screenshot({
      path: fileURLToPath(
        new URL(`../../.test-runtime/results/guide-${label}.png`, import.meta.url),
      ),
    });
    observations.push({ label, ...layout, viewport });
  }

  try {
    assert.equal(
      await search.evaluate((el) => document.activeElement === el),
      true,
      "The guide initially focuses search.",
    );
    for (const height of ["normal", "low"]) {
      if (height === "low") {
        await page.evaluate(() => {
          const win = window.electronWindow;
          if (win.isFullScreen()) win.setFullScreen(false);
          if (win.isMaximized()) win.unmaximize();
        });
        await page.waitForFunction(
          () => !window.electronWindow.isFullScreen() && !window.electronWindow.isMaximized(),
        );
        const lowHeight = Math.max(
          nativeWindow.minimumSize[1],
          Math.min(560, nativeWindow.bounds.height - 100),
        );
        assert.ok(
          lowHeight < nativeWindow.bounds.height - 50,
          "The native minimum height permits a smaller test window.",
        );
        await page.evaluate(
          ({ original, height }) => {
            window.electronWindow.setBounds({ ...original, height });
          },
          { original: nativeWindow.normalBounds, height: lowHeight },
        );
        await page.waitForFunction(
          (normalHeight) => innerHeight < normalHeight - 50,
          observations[0].viewport.height,
        );
      }
      for (const mode of ["light", "dark"]) {
        await page.evaluate((mode) => {
          document.body.classList.toggle("theme-light", mode === "light");
          document.body.classList.toggle("theme-dark", mode === "dark");
        }, mode);
        await settled();
        await exercise(`${height}-${mode}`);
      }
    }
    assert.notEqual(
      observations[0].thumb,
      observations[1].thumb,
      "The scrollbar thumb follows the light/dark theme.",
    );
    return observations;
  } finally {
    await page.evaluate((theme) => {
      document.body.classList.toggle("theme-light", theme.light);
      document.body.classList.toggle("theme-dark", theme.dark);
    }, theme);
    await page.evaluate(() => {
      const win = window.electronWindow;
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    });
    await page.waitForFunction(
      () => !window.electronWindow.isFullScreen() && !window.electronWindow.isMaximized(),
    );
    await page.evaluate((saved) => {
      const win = window.electronWindow;
      win.setBounds(saved.maximized || saved.fullscreen ? saved.normalBounds : saved.bounds);
      if (saved.maximized) win.maximize();
      if (saved.fullscreen) win.setFullScreen(true);
    }, nativeWindow);
    await search.fill("");
    await search.focus();
  }
}
