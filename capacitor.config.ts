import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.deepcompanion.shell',
  appName: 'Deep Companion',
  webDir: 'mobile/www',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  android: {
    allowMixedContent: false,
  },
}

export default config
