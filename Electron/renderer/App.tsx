import React from 'react';

export default function App(): React.JSX.Element {
  return <header className={window.platform === 'darwin' ? 'title-bar title-bar-mac' : 'title-bar'} aria-hidden="true" />;
}
