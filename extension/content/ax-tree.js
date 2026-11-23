/**
 * Page-level ops behind read_page / find / get_page_text / form_input /
 * file_upload / upload_image. Injected on demand into the top frame, and from
 * there the ops also reach same-origin iframes, whose documents this script
 * can read: an app that shows its pages inside its own shell frame is one page
 * to a person. A cross-origin frame stays a single "iframe" line.
 *
 * Walks the DOM and builds an accessibility-style snapshot in which every
 * visible, possibly-interactive element gets a stable-for-this-snapshot ref
 * (e1, e2, ...). The ref -> element map lives in the page until the next walk.
 */
(() => {
  if (globalThis.__agentTabContent) return;
  globalThis.__agentTabContent = true;

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "TITLE", "HEAD", "BASE", "SVG"]);
  const MAX_TEXT = 80;

  let refMap = new Map();
  let refCounter = 0;

  /** The document inside a frame, or null when the page may not read it (another origin). */
  function frameDoc(el) {
    if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") return null;
    try {
      return el.contentDocument || null;
    } catch {
      return null;
    }
  }

  /**
   * The window an element lives in. Its styles, its viewport and the
   * constructors its page checks events against are that window's, not the top
   * one's.
   */
  function viewOf(el) {
    return el.ownerDocument?.defaultView || window;
  }

  /** Every element matching `selector` in the document and in the same-origin frames under it, in page order. */
  function queryAllDeep(doc, selector) {
    const out = [...doc.querySelectorAll(selector)];
    for (const frame of doc.querySelectorAll("iframe, frame")) {
      const inner = frameDoc(frame);
      if (inner) out.push(...queryAllDeep(inner, selector));
    }
    return out;
  }

  function isVisible(el, style) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    switch (tag) {
      case "A": return "link";
      case "BUTTON": return "button";
      case "SELECT": return "combobox";
      case "TEXTAREA": return "textbox";
      case "INPUT": {
        const type = (el.type || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        if (type === "file") return "file-input";
        if (type === "hidden") return null;
        return "textbox";
      }
      case "IMG": return "img";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return `heading${tag.slice(1)}`;
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "ASIDE": return "complementary";
      case "FOOTER": return "contentinfo";
      case "HEADER": return "banner";
      case "FORM": return "form";
      case "TABLE": return "table";
      case "UL": case "OL": return "list";
      case "LI": return "listitem";
      case "IFRAME": return "iframe";
      case "VIDEO": return "video";
      case "AUDIO": return "audio";
      case "CANVAS": return "canvas";
      default: return null;
    }
  }

  function textOf(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function nameOf(el, style) {
    const label = el.getAttribute("aria-label");
    if (label) return label.trim().slice(0, MAX_TEXT);

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter(Boolean)
        .map(textOf)
        .join(" ")
        .trim();
      if (t) return t.slice(0, MAX_TEXT);
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.id) {
        const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return textOf(label).slice(0, MAX_TEXT) || el.getAttribute("placeholder") || el.name || el.id;
      }
      const closest = el.closest("label");
      if (closest) return (textOf(closest) || el.getAttribute("placeholder") || el.name || "").slice(0, MAX_TEXT);
      return (el.getAttribute("placeholder") || el.name || el.getAttribute("title") || "").slice(0, MAX_TEXT);
    }

    if (el.tagName === "IMG") return (el.getAttribute("alt") || el.getAttribute("title") || "").slice(0, MAX_TEXT);

    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent.replace(/\s+/g, " ").trim())
      .join(" ")
      .trim();
    if (ownText) return ownText.slice(0, MAX_TEXT);

    if (el.tagName === "A" || el.tagName === "BUTTON") {
      const t = textOf(el);
      if (t) return t.slice(0, MAX_TEXT);
    }

    return (el.getAttribute("title") || "").slice(0, MAX_TEXT);
  }

  function valueOf(el) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "";
      return (el.value || "").slice(0, MAX_TEXT);
    }
    if (el.tagName === "SELECT") {
      const opt = el.selectedOptions?.[0];
      return opt ? opt.text.trim().slice(0, MAX_TEXT) : "";
    }
    if (el.isContentEditable) return textOf(el).slice(0, MAX_TEXT);
    return null;
  }

  function describe(el) {
    const role = roleOf(el);
    const name = nameOf(el);
    const value = valueOf(el);
    const tag = el.tagName.toLowerCase() + (el.type ? `[type=${el.type}]` : "");
    let line = role ? `${role}` : `${tag}`;
    if (name) line += ` "${name}"`;
    if (!role || !name) line += ` <${tag}>`;
    if (value) line += ` value="${value}"`;
    if (el.disabled) line += " [disabled]";
    if (el.required) line += " [required]";
    if (el.checked) line += " [checked]";
    if (el.tagName === "A" && el.getAttribute("href")) line += ` href=${el.getAttribute("href").slice(0, 60)}`;
    return line;
  }

  function walk(el, depth, out, includeAll) {
    if (!el || SKIP_TAGS.has(el.tagName)) return;
    if (el.type === "hidden") return;
    const style = viewOf(el).getComputedStyle(el);
    if (!isVisible(el, style)) return;

    const role = roleOf(el);
    const interactive = el.tagName === "INPUT" || el.tagName === "BUTTON" || el.tagName === "SELECT" ||
      el.tagName === "TEXTAREA" || el.tagName === "A" || el.isContentEditable ||
      el.getAttribute("onclick") || el.getAttribute("role") === "button";
    const hasName = !!nameOf(el);
    const isLeaf = el.children.length === 0 || el.tagName === "IMG" || el.tagName === "IFRAME";

    if (includeAll || role || interactive || (isLeaf && hasName)) {
      const ref = `e${++refCounter}`;
      refMap.set(ref, el);
      out.push({ depth, ref, text: `${describe(el)} (${ref})` });
    }

    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) walk(child, depth + 1, out, false);
    }
    const inner = frameDoc(el);
    if (inner) walk(inner.body || inner.documentElement, depth + 1, out, false);
    for (const child of el.children) walk(child, depth + 1, out, false);
  }

  function snapshot(includeAll) {
    refMap = new Map();
    refCounter = 0;
    const out = [];
    const root = document.body || document.documentElement;
    walk(root, 0, out, includeAll);
    return out
      .slice(0, 3000)
      .map((n) => `${"  ".repeat(n.depth)}- ${n.text}`)
      .join("\n");
  }

  function resolveTarget({ ref, selector }) {
    if (ref) {
      const el = refMap.get(ref);
      if (el) return el;
      throw new Error(`ref "${ref}" is stale — run read_page or find again`);
    }
    if (selector) {
      const el = queryAllDeep(document, selector)[0];
      if (el) return el;
      throw new Error(`no element matches selector "${selector}"`);
    }
    return null;
  }

  /**
   * An element's centre in its own window, then in each window above it up to
   * the tab's: a frame's viewport starts inside the frame element's border and
   * padding. One entry for an element of the top document.
   */
  function centres(el) {
    const r = el.getBoundingClientRect();
    const out = [];
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    for (let node = el; ; ) {
      const view = viewOf(node);
      out.push({ node, view, x: Math.round(x), y: Math.round(y) });
      const frame = view.frameElement;
      if (!frame) return out;
      const box = frame.getBoundingClientRect();
      const style = viewOf(frame).getComputedStyle(frame);
      x += box.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
      y += box.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);
      node = frame;
    }
  }

  /**
   * Where to click an element named by ref or selector: its centre in the
   * tab's viewport CSS pixels, the coordinates CDP input takes, also for an
   * element inside a same-origin frame. Scrolled into view first. Refused when
   * something else is on top of that point (a cookie banner, a modal, a sticky
   * header), so the click never lands on the overlay in the element's place.
   */
  function locate({ ref, selector }) {
    const el = resolveTarget({ ref, selector });
    if (!el) throw new Error("a click on an element needs its ref (from read_page/find) or a selector");
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) throw new Error("that element has no size on the page now: run read_page again");
    // Visible means visible in every window on the way up: inside its frame's
    // viewport, and that spot of the frame inside the tab's.
    const onScreen = (points) => points.every((p) => p.x >= 0 && p.y >= 0 && p.x < p.view.innerWidth && p.y < p.view.innerHeight);
    const own = viewOf(el);
    const whole = r.top >= 0 && r.left >= 0 && r.bottom <= own.innerHeight && r.right <= own.innerWidth;
    let points = centres(el);
    if (!whole || !onScreen(points)) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      points = centres(el);
    }
    if (!onScreen(points)) throw new Error("that element could not be scrolled into view");
    // Ask the element's own tree. From the document, anything inside a shadow
    // root hit-tests as its host, so every element in a web component looked
    // covered. A shadow root's elementFromPoint still returns an overlay from
    // the page (a cookie banner over the component), so a covered one is
    // still refused. For an element in a frame the same is asked of the frame
    // in its parent, so an overlay over the frame refuses it too.
    for (const p of points) {
      const root = p.node.getRootNode();
      const hit = (typeof root.elementFromPoint === "function" ? root : p.node.ownerDocument).elementFromPoint(p.x, p.y);
      if (hit && hit !== p.node && !p.node.contains(hit)) {
        throw new Error(`something else is on top of that element (${describe(hit)}): close it first, or take a screenshot`);
      }
    }
    const { x, y } = points[points.length - 1];
    return { x, y, width: Math.round(el.getBoundingClientRect().width), target: describe(el) };
  }

  /** Fire a bubbling event of the element's own window, the one its page's code knows. */
  function fire(el, type) {
    el.dispatchEvent(new (viewOf(el).Event)(type, { bubbles: true }));
  }

  function nativeValue(el, value) {
    const view = viewOf(el);
    const proto = el.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    fire(el, "input");
    fire(el, "change");
  }

  function formInput({ value, ref, selector, clear }) {
    const el = resolveTarget({ ref, selector });
    if (!el) throw new Error("form_input needs a ref (from read_page/find) or a selector");
    el.focus?.();
    let target = String(value);

    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      const want = value === true || value === "true" || value === 1 || value === "1";
      if (el.type === "checkbox") el.checked = want;
      else if (want) el.checked = true;
      fire(el, "input");
      fire(el, "change");
      return { target: `${el.tagName.toLowerCase()}[type=${el.type}]`, value: el.checked };
    }

    if (el.tagName === "SELECT") {
      const want = String(value);
      const opt = Array.from(el.options).find((o) => o.value === want || o.text.trim() === want);
      if (!opt) {
        const options = Array.from(el.options).map((o) => o.value).slice(0, 30).join(", ");
        throw new Error(`option "${want}" not in select; options: ${options}`);
      }
      el.value = opt.value;
      fire(el, "input");
      fire(el, "change");
      return { target: "select", value: opt.value };
    }

    if (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "file", "button", "submit", "reset", "image"].includes(el.type))) {
      nativeValue(el, target);
      return { target: el.tagName.toLowerCase(), value: el.value };
    }

    if (el.isContentEditable) {
      el.focus();
      if (clear !== false) viewOf(el).getSelection().selectAllChildren(el);
      el.ownerDocument.execCommand("insertText", false, target);
      fire(el, "input");
      return { target: "contenteditable", value: textOf(el).slice(0, 100) };
    }

    // Last resort: set value if the element has one.
    if ("value" in el) {
      nativeValue(el, target);
      return { target: el.tagName.toLowerCase(), value: el.value };
    }
    throw new Error(`element <${el.tagName.toLowerCase()}> is not a form field`);
  }

  function bytesOf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function fileInputFor(ref, selector) {
    if (ref || selector) {
      const el = resolveTarget({ ref, selector });
      if (el.tagName === "INPUT" && el.type === "file") return el;
      throw new Error(`target ${ref || selector} is not a file input`);
    }
    const visible = queryAllDeep(document, 'input[type="file"]').find((input) => {
      const style = viewOf(input).getComputedStyle(input);
      return isVisible(input, style) || input.closest("form");
    });
    if (!visible) throw new Error("no visible file input found on the page — pass a selector");
    return visible;
  }

  function fileUpload({ files, ref, selector }) {
    if (!files?.length) throw new Error("file_upload needs files: [{name, data(base64), mimeType?}]");
    const input = fileInputFor(ref, selector);
    const view = viewOf(input);
    const dt = new view.DataTransfer();
    for (const f of files) {
      dt.items.add(new view.File([bytesOf(f.data)], f.name || "upload.bin", { type: f.mimeType || "application/octet-stream" }));
    }
    input.files = dt.files;
    fire(input, "input");
    fire(input, "change");
    return { target: `input[type=file]${input.name ? `[name=${input.name}]` : ""}`, names: Array.from(input.files).map((f) => f.name) };
  }

  /** The focused element, followed into a same-origin frame when the focus is inside one. */
  function focused() {
    let el = document.activeElement;
    for (let inner; el && (inner = frameDoc(el)) && inner.activeElement; ) el = inner.activeElement;
    return el;
  }

  /**
   * The text a person can read on the page: the top document's, then each
   * visible same-origin frame's under a line that says a frame starts.
   */
  function pageText(doc) {
    const parts = [doc.body?.innerText || doc.documentElement?.innerText || ""];
    for (const frame of doc.querySelectorAll("iframe, frame")) {
      const inner = frameDoc(frame);
      if (!inner || !isVisible(frame, viewOf(frame).getComputedStyle(frame))) continue;
      const text = pageText(inner).trim();
      if (text) parts.push(`[iframe${frame.title ? ` "${frame.title}"` : ""}]\n${text}`);
    }
    return parts.join("\n\n");
  }

  function uploadImage({ data, mimeType = "image/png", name = "image.png", ref, selector }) {
    if (!data) throw new Error("upload_image needs data (base64 image)");
    const target = (ref || selector) ? resolveTarget({ ref, selector }) : focused() || document.body;

    if (target.tagName === "INPUT" && target.type === "file") {
      return fileUpload({ files: [{ data, mimeType, name }], ref, selector });
    }

    const view = viewOf(target);
    const dt = new view.DataTransfer();
    dt.items.add(new view.File([bytesOf(data)], name, { type: mimeType }));
    const pasteInit = { bubbles: true, cancelable: true, clipboardData: dt };
    let delivered = false;
    try {
      delivered = target.dispatchEvent(new view.ClipboardEvent("paste", pasteInit));
    } catch {}
    try {
      target.dispatchEvent(new view.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    } catch {}
    if (!delivered) {
      target.ownerDocument.dispatchEvent(new view.ClipboardEvent("paste", pasteInit));
    }
    return { target: target.tagName.toLowerCase(), summary: `dispatched paste/drop with ${name} (${mimeType}) on <${target.tagName.toLowerCase()}>` };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "taskwindow:op") return;
    (async () => {
      try {
        switch (msg.op) {
          case "read_page": {
            const tree = snapshot(false);
            sendResponse({ ok: true, text: tree, refCount: refMap.size });
            break;
          }
          case "find": {
            const query = String(msg.params.query || "").toLowerCase();
            if (!query) throw new Error("find needs a query");
            // Rebuild refs for the whole page so returned refs are usable.
            refMap = new Map();
            refCounter = 0;
            const nodes = [];
            walk(document.body || document.documentElement, 0, nodes, false);
            const matches = nodes
              .filter((n) => n.text.toLowerCase().includes(query))
              .slice(0, 50)
              .map((n) => `${"  ".repeat(n.depth)}- ${n.text}`);
            sendResponse({ ok: true, matches, refCount: refMap.size });
            break;
          }
          case "locate": {
            sendResponse({ ok: true, ...locate(msg.params || {}) });
            break;
          }
          case "get_page_text": {
            const max = msg.params.maxLength || 50000;
            const text = pageText(document).slice(0, max);
            sendResponse({ ok: true, text: text + (text.length >= max ? "\n…[truncated]" : "") });
            break;
          }
          case "form_input": {
            const result = formInput(msg.params);
            sendResponse({ ok: true, result });
            break;
          }
          case "file_upload": {
            const result = fileUpload(msg.params);
            sendResponse({ ok: true, result });
            break;
          }
          case "upload_image": {
            const result = uploadImage(msg.params);
            sendResponse({ ok: true, result, summary: result.summary });
            break;
          }
          default:
            sendResponse({ ok: false, error: `unknown op "${msg.op}"` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true; // async response
  });
})();
