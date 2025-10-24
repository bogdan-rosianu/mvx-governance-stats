import React from 'react'

export function Button({ className = '', children, ...props }) {
  return (
    <button
      className={`px-3 py-2 border rounded bg-white hover:bg-gray-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

