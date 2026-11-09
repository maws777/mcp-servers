// The only way this page creates DOM: elements and text nodes. Strings are
// always inserted as text (document.createTextNode), never parsed as HTML,
// so a meal described as "<img src=x onerror=...>" shows up as those
// characters. scripts/check-web.mjs fails CI if any HTML-parsing API appears.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG elements, for the charts. Attributes are numbers or fixed strings. */
export function s(tag: string, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}
