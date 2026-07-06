// Shared authoritative state machine — no I/O, safe to import in client and server.
export type Entity = {
	x: number
	y: number
}

export type Snapshot = {
	entities: Record<string, Entity>
}

export type Action =
	| { type: "JOIN"; entityId: string } // server-initiated on connect
	| { type: "MOVE"; entityId: string; dx: number; dy: number } // client-initiated
	| { type: "LEAVE"; entityId: string } // server-initiated on disconnect

export const emptySnapshot = (): Snapshot => ({ entities: {} })

export function reducer(snapshot: Snapshot, action: Action): Snapshot {
	switch (action.type) {
		case "JOIN":
			return {
				entities: {
					...snapshot.entities,
					[action.entityId]: { x: 0, y: 0 },
				},
			}
		case "MOVE": {
			const entity = snapshot.entities[action.entityId]
			if (!entity) return snapshot

			return {
				entities: {
					...snapshot.entities,
					[action.entityId]: {
						x: entity.x + action.dx,
						y: entity.y + action.dy,
					},
				},
			}
		}
		case "LEAVE": {
			const { [action.entityId]: _, ...entities } = snapshot.entities
			return { entities }
		}
	}
}
