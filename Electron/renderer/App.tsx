import React, { useState } from 'react';

export default function App(): React.JSX.Element {
  const [text, setText] = useState<string>('');

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
