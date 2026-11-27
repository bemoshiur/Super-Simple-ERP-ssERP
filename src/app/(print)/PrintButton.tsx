'use client'

/** Opens the browser print dialog; "Save as PDF" there gives a PDF download. */
const PrintButton = ({ label = 'Print' }: { label?: string }) => (
  <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}>
    {label}
  </button>
)

export default PrintButton
