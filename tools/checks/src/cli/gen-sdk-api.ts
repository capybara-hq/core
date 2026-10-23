import { checkSdkApi, DEFAULT_SDK_DIR, SDK_API_REPORT_FILE } from "../sdk-api.js";

await checkSdkApi({ update: true });
console.log(`wrote ${DEFAULT_SDK_DIR}/${SDK_API_REPORT_FILE}`);
