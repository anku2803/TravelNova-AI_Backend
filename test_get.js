const http = require('http');
http.get('http://localhost:5000/api/ai/status', res => {
  let b=''; res.on('data',c=>b+=c); res.on('end', ()=>console.log('STATUS', res.statusCode, 'BODY', b));
}).on('error', e=>console.error(e));
