import fs from 'fs';
import https from 'https';

https.get('https://gist.githubusercontent.com/damepa/9cce4d10a3ec89467ae50e289bffc4e3/raw', (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    fs.writeFileSync('gist.html', data);
    console.log('Downloaded');
  });
}).on('error', (err) => {
  console.error(err);
});
