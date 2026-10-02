import { Config, configValues } from '../index.js'
export const resolvedConfig = raw => configValues(Config(raw))
