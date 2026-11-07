const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
assert.equal(process.getuid(), 1000);
assert.equal(fs.existsSync('/source'), false, 'execution must not mount host checkout');
assert.equal(fs.existsSync('/var/run/docker.sock'), false, 'execution must not mount Docker socket');
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
  assert.equal(process.env[name], undefined, 'credential environment must not enter execution container');
}
const socket = net.createConnection({ host: '1.1.1.1', port: 443 });
const timer = setTimeout(() => { socket.destroy(); throw new Error('Network isolation was not established'); }, 2000);
socket.once('connect', () => { clearTimeout(timer); socket.destroy(); throw new Error('External network was reachable'); });
socket.once('error', error => {
  clearTimeout(timer);
  assert.equal(error.code, 'ENETUNREACH');
  console.log('CI boundary verified: nonroot, no host checkout/socket/credential env, external network unreachable');
});
