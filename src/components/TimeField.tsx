/** Compact 24-hour time display that opens the native time picker when tapped. */
export function TimeField(props: { value?: string; onChange(v: string | undefined): void }) {
  return (
    <label className="time-field">
      <span className={props.value ? '' : 'muted'}>{props.value || '--:--'}</span>
      <input
        type="time"
        aria-label="時間"
        value={props.value ?? ''}
        onChange={(e) => props.onChange(e.target.value || undefined)}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            /* not supported; the browser's own behaviour applies */
          }
        }}
      />
    </label>
  );
}
