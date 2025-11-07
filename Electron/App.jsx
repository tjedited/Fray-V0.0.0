import React, { useEffect, useState } from 'react';

export default function App() {
  const [osText, setOsText] = useState('Unknown OS');
  const [info, setInfo] = useState('');

  useEffect(() => {
    // Get platform from window.platform (exposed by preload.js)
    let os = 'Unknown OS';
    switch (window.platform) {
      case 'darwin':
        os = 'Mac';
        break;
      case 'win32':
        os = 'Windows';
        break;
      case 'linux':
        os = 'Linux';
        break;
      default:
        os = window.platform || 'Unknown OS';
    }
    setOsText(os);

    // Get versions from window.versions (exposed by preload.js)
    if (window.versions) {
      setInfo(
        `This app is using Chrome (v${window.versions.chrome()}), Node.js (v${window.versions.node()}), and Electron (v${window.versions.electron()})`
      );
    }
  }, []);

  return (
    <div>
      <h1>Hello from Electron renderer on {osText}!</h1>
      <p>{info}</p>
      <p>👋</p>
    </div>
  );
}