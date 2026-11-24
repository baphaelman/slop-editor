// The slop editor in a React app: `import { SlopText, SlopMeter, slopAttrs, useSlop } from 'slop-editor/react'`.
// slop.js has to be in the page first, as a plain <script>: this hands its global Slop to the modules. No JSX and no
// build, so it works from node_modules as it is. MIT license.
import { createElement, Fragment, useSyncExternalStore } from 'react';

/* global Slop */
// slop.js declares Slop with const: a global name, but not a property of window
const slop = typeof Slop === 'undefined' ? null : Slop;
if (!slop) throw new Error('slop-editor/react: put slop.js in the page before this module');
export default slop;

// after an edit in the editor, every component that called useSlop() renders again
let version = 0;
const subscribers = new Set();
slop.onChange(() => {
    version++;
    subscribers.forEach((fn) => fn());
});
const subscribe = (fn) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
};
const snapshot = () => version;
export const useSlop = () => useSyncExternalStore(subscribe, snapshot, snapshot);

// a text as HTML, in a span (or `as`). React draws it; data-slop-ref lets the editor find it on the page. `vars` fill
// in {name}s for this one text. As a p, li or dd, each paragraph after a blank line gets one of its own
export function SlopText({ path, as = 'span', vars, ...props }) {
    useSlop();
    const ref = { 'data-slop-ref': path };
    if (!['p', 'li', 'dd'].includes(as)) return createElement(as, { ...props, ...ref, dangerouslySetInnerHTML: { __html: slop.html(path, vars) } });
    const parts = slop.paragraphs(path, vars);
    if (parts.length === 1) return createElement(as, { ...props, ...ref, dangerouslySetInnerHTML: { __html: parts[0] } });
    const { id, ...rest } = props;
    return createElement(Fragment, null, ...parts.map((h, i) => createElement(as, { ...(i ? rest : props), ...ref, key: i, dangerouslySetInnerHTML: { __html: h } })));
}

// a group the page shows as a list (paragraphs it draws one by one): the editor can add and remove texts in it.
// <div {...slopList('intro')}>{…a <SlopText as="p"> for each…}</div>
export const slopList = (path) => ({ 'data-slop-list-ref': path });

// attributes from texts, as plain text: <img {...slopAttrs({ alt: 'hero.photo' })} />. The editor lists them under
// Hidden. Call it from a component that calls useSlop(), so they follow edits
export function slopAttrs(attrs, vars) {
    const pairs = Object.entries(attrs);
    const out = Object.fromEntries(pairs.map(([name, path]) => [name, slop.words(path, vars)]));
    out['data-slop-attr'] = pairs.map(([name, path]) => `${name}:${path}`).join(' ');
    if (vars) out['data-slop-vars'] = JSON.stringify(vars);
    return out;
}

// a Slop-o-meter: the page's, or with a path, a group's, whose switch colors only its section (the closest
// [data-slop-section], or its parent). slop.js builds what's inside
export function SlopMeter({ path, className, ...props }) {
    return createElement('div', { ...props, className: className ? `slop-meter ${className}` : 'slop-meter', 'data-slop-meter': path ?? '' });
}
