// Peer-local loopback gateway to the isolated third-network fixture. No Internet forwarding.
import http from 'node:http';
import net from 'node:net';
const port=Number(process.argv[2]);
const server=http.createServer((request,response)=>{
  const proxy=http.request({host:'10.77.0.1',port,path:request.url,method:request.method,headers:request.headers},upstream=>{response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response);});
  proxy.on('error',()=>{response.writeHead(502);response.end();});request.pipe(proxy);
});
server.on('upgrade',(request,socket,head)=>{
  const target=net.connect(port,'10.77.0.1',()=>{target.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Object.entries(request.headers).map(([key,value])=>`${key}: ${value}`).join('\r\n')}\r\n\r\n`);if(head.length)target.write(head);socket.pipe(target);target.pipe(socket);});
  target.on('error',()=>socket.destroy());socket.on('error',()=>target.destroy());socket.on('close',()=>target.destroy());
});
server.listen(port,'127.0.0.1');
