import { useState } from 'react';
import { Modal } from './Modal';

/** Manual paste box, for browsers that will not hand the clipboard over. */
export function PasteModal(props: { title: string; hint: string; submitLabel: string; onSubmit(text: string): void; onClose(): void }) {
  const [text, setText] = useState('');
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <span className="grow" />
          <button
            className="btn btn-primary"
            disabled={!text.trim()}
            onClick={() => {
              props.onSubmit(text);
              props.onClose();
            }}
          >
            {props.submitLabel}
          </button>
        </>
      }
    >
      <p className="hint" style={{ marginTop: 0 }}>
        {props.hint}
      </p>
      <textarea
        className="textarea"
        style={{ minHeight: 200 }}
        autoFocus
        value={text}
        placeholder="長按這裡 →「貼上」"
        onChange={(e) => setText(e.target.value)}
      />
    </Modal>
  );
}
