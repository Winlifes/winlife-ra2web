// Use the upstream bundled FFmpeg (Bink decoder / VP8 encoder), offline.
// node transcode-menu.cjs /path/to/upstream/js /path/to/ra2ts_l.bik /path/to/menu.webm
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const [js, input, output] = process.argv.slice(2);
  const core = await require(path.resolve(js, 'ffmpeg-core.js'))({
    wasmBinary: fs.readFileSync(path.resolve(js, 'ffmpeg-core.wasm')),
    print: () => {}, printErr: () => {},
  });
  core.FS.writeFile('input.bik', fs.readFileSync(input));
  const args = ['ffmpeg', '-i', 'input.bik', '-an', '-c:v', 'libvpx', '-b:v', '1500k', '-y', 'menu.webm'];
  const argv = core._malloc((args.length + 1) * 4);
  args.forEach((arg, i) => {
    const ptr = core._malloc(arg.length + 1);
    core.writeAsciiToMemory(arg, ptr);
    core.setValue(argv + i * 4, ptr, 'i32');
  });
  core.setValue(argv + args.length * 4, 0, 'i32');
  const code = core.cwrap('main', 'number', ['number', 'number'])(args.length, argv);
  if (code) throw new Error('FFmpeg returned ' + code);
  fs.writeFileSync(output, core.FS.readFile('menu.webm'));
  console.log('Converted original menu:', fs.statSync(output).size, 'bytes');
})();
