import { useEffect } from 'react'

const BASE_TITLE = 'PixMap'

export function useCooldownTabTitle(label) {
  useEffect(() => {
    document.title = label ? `${label} | ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [label])
}
