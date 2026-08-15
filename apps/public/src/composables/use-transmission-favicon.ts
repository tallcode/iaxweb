import type { PublicNodeStatus, PublicStatusSnapshot } from '@iaxweb/contracts'
import type { Ref } from 'vue'
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { TransmissionFavicon } from '../services/transmission-favicon'

export function isFaviconTransmission(node: PublicNodeStatus | undefined): boolean {
  return node?.TYPE !== 'HUB' && (node?.TX_SOURCE === 'local' || node?.TX_SOURCE === 'remote')
}

export function useTransmissionFavicon(snapshot: Ref<PublicStatusSnapshot>): void {
  let favicon: TransmissionFavicon | undefined

  const sync = (): void => {
    favicon?.setTransmitting(Object.values(snapshot.value).some(isFaviconTransmission))
  }

  onMounted(() => {
    favicon = new TransmissionFavicon()
    sync()
  })

  onBeforeUnmount(() => favicon?.setTransmitting(false))

  watch(snapshot, sync, { deep: true })
}
