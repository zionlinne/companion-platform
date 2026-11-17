import { IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import styles from './MobileHeader.module.css'

/**
 * Mobile title bar from the chat shell.
 * The sidebar button is omitted: that list is the demo's browser-local sessions.
 * This app already has its own navigation, and conversations stay on the server.
 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  return (
    <div className={styles.header}>
      <div className={styles.title}>{title ?? t('untitledChat')}</div>
      {title === undefined ? null : (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconNewChatOutline20 />}
          aria-label={t('newChat')}
          onClick={newChat}
        />
      )}
    </div>
  )
}
