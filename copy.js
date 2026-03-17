import fs from 'fs';
fs.mkdirSync('public', { recursive: true });
fs.copyFileSync('gist.html', 'public/index.html');
console.log('Copied');
