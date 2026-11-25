import React, { useState } from 'react';

export default function App() {
  const [text, setText] = useState('');

  return (
    <div>
      <input
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Project name"
      />
      <button type="button">Add</button>
    </div>
  );
}
