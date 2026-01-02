import { TwelveLabs } from 'twelvelabs-js';
import { TWELVE_LABS_API_KEY } from '../config/index.js';

const TwelveLabsClient = new TwelveLabs({
    apiKey: TWELVE_LABS_API_KEY,
});

export default TwelveLabsClient;