/**
 * Just enough XML to read Office documents.
 *
 * A full parser is not needed and would not help: OOXML is machine-generated,
 * well-formed, and we only ever pull known element and attribute names out of
 * it. What matters is that text comes out in document order, so paragraphs
 * read the way the student wrote them and sentence statistics mean something.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Numeric entities are a common hiding place: &#8203; is a zero-width
      // space that no editor will show. Decode it so the scanner can see it.
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Read one attribute off a raw start-tag string. */
export function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

/** All text inside the first <name>...</name>, tags stripped. */
export function tagText(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')) : null;
}

/** Every occurrence of an attribute across the document, in order. */
export function allAttrs(xml, tagName, attrName) {
  const out = [];
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const v = attr(m[0], attrName);
    if (v != null) out.push(v);
  }
  return out;
}

/** Count start tags of a given name (self-closing included). */
export function countTags(xml, name) {
  const m = xml.match(new RegExp(`<${name}[\\s/>]`, 'g'));
  return m ? m.length : 0;
}

/**
 * Walk an XML document, emitting text through a handler that decides what each
 * element contributes. Keeps document order, which regex-per-element does not.
 */
export function walkText(xml, handlers) {
  let out = '';
  const re = /<([^>]*)>/g;
  let last = 0;
  let m;
  const stack = [];

  while ((m = re.exec(xml))) {
    const between = xml.slice(last, m.index);
    if (between && stack.length && handlers.keepText?.(stack[stack.length - 1])) {
      out += decodeEntities(between);
    }
    last = re.lastIndex;

    const raw = m[1];
    if (raw.startsWith('?') || raw.startsWith('!')) continue;

    const closing = raw.startsWith('/');
    const selfClosing = raw.endsWith('/');
    const name = raw.replace(/^\//, '').split(/[\s/>]/)[0];

    if (selfClosing) {
      out += handlers.empty?.(name, `<${raw}>`) ?? '';
    } else if (closing) {
      stack.pop();
      out += handlers.close?.(name) ?? '';
    } else {
      stack.push(name);
      out += handlers.open?.(name, `<${raw}>`) ?? '';
    }
  }
  return out;
}
