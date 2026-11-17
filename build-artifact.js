// Builds dist/crosstown-artifact.html: one self-contained page (no server) for publishing as a claude.ai artifact.
const fs = require('fs');
const path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = rd('public/index.html');
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const body = html.match(/<body>([\s\S]*?)<script/)[1];
const js = ['public/voices.js', 'shared/shared.js', 'shared/fight.js', 'shared/game.js', 'public/room.js', 'public/client.js'].map((f) => {
  const src = rd(f);
  if (/<\/script/i.test(src)) throw new Error(f + ' contains </script');
  return `<script>\n${src}\n</script>`;
}).join('\n');
const out = `<title>RoxTown Carnage</title>
<style>
:root { color-scheme: dark; }
${style}
</style>
${body.trim()}
${js}
`;
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'crosstown-artifact.html'), out);
console.log('wrote dist/crosstown-artifact.html', (out.length / 1024).toFixed(0) + ' KB');
