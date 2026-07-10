export interface DeviceCodeAuthResult {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

export class DeviceCodeAuthProvider {
  async signIn(): Promise<DeviceCodeAuthResult> {
    throw new Error('Device Code login is not implemented yet.');
  }
}
