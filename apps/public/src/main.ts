import { createPinia } from 'pinia'
import { createApp } from 'vue'
import TopologyPage from './pages/TopologyPage.vue'
import './styles.css'

createApp(TopologyPage)
  .use(createPinia())
  .mount('#app')
