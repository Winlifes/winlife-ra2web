import { parseMap, serializeMap } from './map-codec.mjs?v=workshop1';
import { restoreEditorState } from './editor-state.mjs?v=perf1';
let document, epoch;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') { document = parseMap(data.text); epoch = data.epoch; return; }
    if (data.type !== 'encode' || data.epoch !== epoch || !document) throw new Error('Map encoder is not ready');
    restoreEditorState(document, data.state);
    self.postMessage({ id: data.id, text: serializeMap(document) });
  } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }); }
};
