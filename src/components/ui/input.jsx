import React from 'react'

export const Input = React.forwardRef(function Input(
  { className = '', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`border rounded px-2 py-1 ${className}`}
      {...props}
    />
  )
})

