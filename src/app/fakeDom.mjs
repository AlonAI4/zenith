/**
 * A small stand-in for a web page, for tests that install a whole add-on.
 *
 * It has only what Zenith's add-ons use: making elements, putting them in the
 * page, attributes, text, focus and events. Selectors are the simple kinds
 * ('#id', '.class', 'tag', '[name=value]'); anything else throws, so a test
 * that needs more says so instead of passing by accident. Events do not
 * bubble: dispatch them on the element (or window) that listens.
 */

const matcher = (selector) => {
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return (node) => node.id === id[1];
  const cls = /^\.([\w-]+)$/.exec(selector);
  if (cls) return (node) => node.classList.contains(cls[1]);
  const attr = /^\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(selector);
  if (attr) return (node) => node.getAttribute(attr[1]) === attr[2];
  if (/^[a-z][\w-]*$/i.test(selector)) {
    return (node) => node.tagName === selector.toUpperCase();
  }
  throw new Error(`fakeDom does not understand the selector "${selector}"`);
};

class FakeElement extends EventTarget {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.id = '';
    this.innerHTML = '';
    this.ownText = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name);
        else classes.delete(name);
        return force;
      },
    };
  }

  get className() {
    return this.getAttribute('class') ?? '';
  }

  set className(value) {
    for (const name of this.className.split(/\s+/).filter(Boolean)) {
      this.classList.remove(name);
    }
    this.setAttribute('class', value);
    for (const name of String(value).split(/\s+/).filter(Boolean)) {
      this.classList.add(name);
    }
  }

  get textContent() {
    return (
      this.ownText + this.children.map((child) => child.textContent).join('')
    );
  }

  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = String(value ?? '');
  }

  /** A canvas that accepts every drawing command and draws nothing. */
  getContext() {
    const drawn = {};
    return new Proxy(drawn, {
      get: (target, key) => (key in target ? target[key] : () => {}),
    });
  }

  toDataURL() {
    return 'data:,';
  }

  /** Every element sits at the top left with no size: there is no layout. */
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  get childNodes() {
    return this.children;
  }

  /** A copy, with its attributes, classes, text and (if deep) children. */
  cloneNode(deep = false) {
    const copy = new FakeElement(this.ownerDocument, this.tagName);
    for (const [name, value] of this.attributes) copy.setAttribute(name, value);
    copy.className = this.className;
    copy.id = this.id;
    copy.ownText = this.ownText;
    copy.innerHTML = this.innerHTML;
    if (deep) {
      for (const child of this.children)
        copy.appendChild(child.cloneNode(true));
    }
    return copy;
  }

  prepend(...nodes) {
    const kept = this.children;
    this.children = [];
    this.append(...nodes);
    for (const child of kept) this.children.push(child);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') this.ownText += node;
      else this.appendChild(node);
    }
  }

  appendChild(node) {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  removeChild(node) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    this.textContent = '';
    this.append(...nodes);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  contains(node) {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  click() {
    this.dispatchEvent(new Event('click', { cancelable: true }));
  }

  /** Every element below this one, in page order. */
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selector) {
    const matches = matcher(selector);
    return [...this.descendants()].filter(matches);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** A fresh page with an empty head and body, and a window to go with it. */
export function fakeDocument() {
  const doc = new EventTarget();
  doc.documentElement = new FakeElement(doc, 'html');
  doc.head = doc.documentElement.appendChild(new FakeElement(doc, 'head'));
  doc.body = doc.documentElement.appendChild(new FakeElement(doc, 'body'));
  doc.activeElement = doc.body;
  doc.createElement = (tag) => new FakeElement(doc, tag);
  doc.createElementNS = (namespace, tag) => new FakeElement(doc, tag);
  doc.getElementById = (id) =>
    [...doc.documentElement.descendants()].find((node) => node.id === id) ??
    null;
  doc.querySelectorAll = (selector) =>
    doc.documentElement.querySelectorAll(selector);
  doc.querySelector = (selector) => doc.documentElement.querySelector(selector);
  const win = new EventTarget();
  win.document = doc;
  win.setTimeout = (fn, ms) => setTimeout(fn, ms);
  win.clearTimeout = (handle) => clearTimeout(handle);
  win.matchMedia = () => ({ matches: false });
  doc.defaultView = win;
  return doc;
}
