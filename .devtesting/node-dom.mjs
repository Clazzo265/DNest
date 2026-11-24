/**
 * LOCAL HARNESS ONLY: the few browser globals the transfer engine needs when it
 * is exercised from Node tests (FileReader / Blob reading).
 */
import { readFileSync } from 'node:fs';

if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReader {
    onerror = null;
    onload = null;
    result = null;
    readAsDataURL(blob) {
      Promise.resolve()
        .then(async () => {
          const buffer = Buffer.from(await blob.arrayBuffer());
          this.result = 'data:' + (blob.type || '') + ';base64,' + buffer.toString('base64');
          this.onload?.();
        })
        .catch(error => this.onerror?.(error));
    }
  }
  globalThis.FileReader = NodeFileReader;
}

void readFileSync;
