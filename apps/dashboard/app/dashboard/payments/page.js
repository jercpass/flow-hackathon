'use client'
import { useEffect, useState } from 'react'
import { api } from '../../../lib/api'
import PayPalPayments from './PayPalPayments'
import Ledger from './Ledger'

export default function Payments() {
  const [status, setStatus] = useState(null)
  useEffect(() => { api('/dashboard/payments').then(setStatus) }, [])
  if (!status) return <div className="skel skel-block" aria-label="Loading" />
  return (
    <>
      <PayPalPayments status={status} setStatus={setStatus} />
      <Ledger />
    </>
  )
}
