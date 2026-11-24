/** LOCAL HARNESS ONLY: minimal browser globals for download tests. */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.URL.createObjectURL ??= () => 'blob:test';
globalThis.URL.revokeObjectURL ??= () => {};
