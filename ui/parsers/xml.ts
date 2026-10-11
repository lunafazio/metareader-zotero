/** Namespace-agnostic XML helpers (TEI and JATS may or may not carry a default namespace). */

export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("XML parse error: " + err.textContent?.slice(0, 300));
  return doc;
}

export function kids(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === name);
}

export function firstDesc(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  return el.getElementsByTagNameNS("*", name)[0] ?? null;
}

export function textOf(el: Element | null | undefined): string {
  return el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** Local name of the root element, sniffed from the head of a (possibly truncated) XML string. */
export function rootName(xml: string): string {
  const body = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![A-Z][^>]*>/g, "");
  return body.match(/<(?:[\w-]+:)?([\w-]+)/)?.[1] ?? "";
}
