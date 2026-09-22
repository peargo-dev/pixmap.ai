import PanelHeader from '../PanelHeader.jsx'

export default function HelpPanel({ onClose }) {
  return (
    <div id="panel-help" className="panel">
      <PanelHeader title="How to play" panelId="panel-help" onClose={onClose} />
      <div className="panel-body">
        <h3>Placing pixels</h3>
        <p>Select a color from the palette at the bottom-right, then click the canvas to place.</p>
        <h3>Cooldown</h3>
        <p>Placing on empty space costs <strong>0.5s</strong>, on placed pixels costs <strong>1s</strong>. Max stack: 2 minutes. All enforced server-side.</p>
        <h3>Controls</h3>
        <ul>
          <li>Scroll — zoom in/out</li>
          <li>Drag — pan camera</li>
          <li>Click — place pixel</li>
          <li>Shift + drag — paint pixels</li>
        </ul>
        <h3>Rules</h3>
        <ul>
          <li>No bots or automation</li>
          <li>Be respectful of others' art</li>
          <li>One account per person</li>
        </ul>
      </div>
    </div>
  )
}
