export enum RoomVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
}

export enum RoomPersistence {
  PERSISTENT = 'PERSISTENT',
  EPHEMERAL = 'EPHEMERAL',
}

export enum RoomEncryption {
  PLAINTEXT = 'PLAINTEXT',
  AES = 'AES',
}

export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  BANNED = 'BANNED',
}

export enum BanReason {
  RATE_LIMIT_COLLISION = 'RATE_LIMIT_COLLISION',
  ADMIN = 'ADMIN',
}

export enum MessageType {
  TEXT = 'TEXT',
  PIXEL = 'PIXEL',
  POLL = 'POLL',
  SYSTEM = 'SYSTEM',
}
