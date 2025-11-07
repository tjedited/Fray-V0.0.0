const information = document.getElementById('info');
information.innerText = `This app is using Chrome (v${versions.chrome()}), Node.js (v${versions.node()}), and Electron (v${versions.electron()})`;

window.addEventListener('DOMContentLoaded', () => {
  const h1 = document.querySelector('h1');
  let osText = 'Unknown OS';

  // Use window.platform exposed by preload.js
  switch (window.platform) {
    case 'darwin':
      osText = 'Mac';
      break;
    case 'win32':
      osText = 'Windows';
      break;
    case 'linux':
      osText = 'Linux';
      break;
  }

  h1.textContent = `Hello from Electron renderer on ${osText}!`;
});