import React from 'react'

export function Card({ className = '', children, ...props }) {
  return (
    <div className={`border rounded-2xl bg-white ${className}`} {...props}>
      {children}
    </div>
  )
}

export function CardContent({ className = '', children, ...props }) {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  )
}
