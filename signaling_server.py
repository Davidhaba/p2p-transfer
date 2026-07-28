import asyncio
import json
import os
import signal
from typing import Dict, Optional, Set
import websockets
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

class SignalingServer:
    def __init__(self):
        self.devices: Dict[str, websockets.WebSocketServerProtocol] = {}
        self.device_info: Dict[str, Dict] = {}
        self.rooms: Dict[str, Set[str]] = {}
    
    def register_device(self, device_id: str, websocket: websockets.WebSocketServerProtocol, device_name: str) -> None:
        """Register a device with the server"""
        self.devices[device_id] = websocket
        self.device_info[device_id] = {
            'id': device_id,
            'name': device_name,
            'connected': True
        }
        print(f"[server] Device registered: {device_id} ({device_name})")
    
    def unregister_device(self, device_id: str) -> None:
        """Unregister a device and remove it from any room"""
        if device_id in self.devices:
            del self.devices[device_id]
        if device_id in self.device_info:
            del self.device_info[device_id]

        for room_id, members in list(self.rooms.items()):
            if device_id in members:
                members.remove(device_id)
                if not members:
                    del self.rooms[room_id]
                print(f"[server] Device {device_id} removed from room {room_id}")
        print(f"[server] Device unregistered: {device_id}")
    
    def get_available_devices(self, exclude_device_id: str) -> list:
        """Get list of available devices (excluding self)"""
        return [
            info for dev_id, info in self.device_info.items()
            if dev_id != exclude_device_id and info['connected']
        ]

    def get_room_peers(self, room_id: str, exclude_device_id: Optional[str] = None) -> list:
        members = self.rooms.get(room_id, set())
        peers = []
        for member_id in members:
            if member_id == exclude_device_id:
                continue
            info = self.device_info.get(member_id)
            if info:
                peers.append({
                    'deviceId': member_id,
                    'deviceName': info['name'],
                })
        return peers

    async def relay_signal(self, from_device_id: str, to_device_id: str, signal: Dict) -> bool:
        """Relay WebRTC signaling (SDP, ICE) between devices"""
        if to_device_id not in self.devices:
            print(f"[server] Target device {to_device_id} not found")
            return False
        
        target_websocket = self.devices[to_device_id]
        message = {
            'type': 'signal',
            'from': from_device_id,
            'signal': signal
        }
        
        try:
            await target_websocket.send(json.dumps(message))
            print(f"[server] Signal relayed: {from_device_id} -> {to_device_id}")
            return True
        except Exception as e:
            print(f"[server] Failed to relay signal: {e}")
            return False

    async def safe_send(self, websocket: websockets.WebSocketServerProtocol, message: Dict) -> bool:
        try:
            await websocket.send(json.dumps(message))
            return True
        except Exception as e:
            print(f"[server] Safe send failed: {e}")
            return False

    def join_room(self, room_id: str, device_id: str) -> None:
        members = self.rooms.setdefault(room_id, set())
        if device_id not in members:
            members.add(device_id)
            print(f"[server] Device {device_id} joined room {room_id}")

    async def broadcast_peer_joined(self, room_id: str, device_id: str, device_name: str) -> None:
        members = self.rooms.get(room_id, set())
        if not members:
            return

        message = {
            'type': 'peer_joined',
            'room': room_id,
            'deviceId': device_id,
            'deviceName': device_name,
        }

        for member_id in list(members):
            if member_id == device_id:
                continue
            if member_id not in self.devices:
                continue
            try:
                await self.devices[member_id].send(json.dumps(message))
                print(f"[server] Notified {member_id} about new peer {device_id}")
            except Exception as e:
                print(f"[server] Failed to notify {member_id} about new peer {device_id}: {e}")

    async def broadcast_peer_left(self, room_id: str, device_id: str, device_name: str) -> None:
        members = self.rooms.get(room_id, set())
        if not members:
            return

        message = {
            'type': 'peer_left',
            'room': room_id,
            'deviceId': device_id,
            'deviceName': device_name,
        }

        for member_id in list(members):
            if member_id == device_id:
                continue
            if member_id not in self.devices:
                continue
            try:
                await self.devices[member_id].send(json.dumps(message))
            except Exception:
                pass

server = SignalingServer()

async def handler(websocket, path=None):
    device_id: Optional[str] = None
    try:
        async for message_str in websocket:
            try:
                message = json.loads(message_str)
            except json.JSONDecodeError:
                continue
            
            msg_type = message.get('type')
            
            # Registration
            if msg_type == 'register':
                device_id = message.get('deviceId')
                device_name = message.get('deviceName', 'Unknown')
                
                if not device_id:
                    await server.safe_send(websocket, {
                        'type': 'error',
                        'message': 'Missing deviceId for registration.'
                    })
                    continue

                if device_id in server.devices and server.devices[device_id] is not websocket:
                    server.unregister_device(device_id)

                server.register_device(device_id, websocket, device_name)
                
                # Send registration confirmation
                await server.safe_send(websocket, {
                    'type': 'registered',
                    'deviceId': device_id
                })
                continue
            
            if device_id is None:
                await server.safe_send(websocket, {
                    'type': 'error',
                    'message': 'Device is not registered.'
                })
                continue
            
            # Get available devices (discovery)
            if msg_type == 'list_devices':
                available = server.get_available_devices(device_id)
                await server.safe_send(websocket, {
                    'type': 'device_list',
                    'devices': available
                })
                continue
            
            if msg_type == 'join':
                room_id = message.get('room')
                client_name = message.get('clientName', device_id)
                if not room_id:
                    await server.safe_send(websocket, {
                        'type': 'error',
                        'message': 'Missing room id for join.'
                    })
                    continue
                existing_peers = server.get_room_peers(room_id, exclude_device_id=device_id)
                server.join_room(room_id, device_id)
                await server.safe_send(websocket, {
                    'type': 'joined',
                    'room': room_id,
                    'clientName': client_name,
                    'deviceId': device_id,
                    'peers': existing_peers,
                })
                await server.broadcast_peer_joined(room_id, device_id, client_name)
                continue
            
            if msg_type == 'signal':
                if device_id:
                    target_id = message.get('to')
                    signal = message.get('signal')
                    
                    if target_id and signal:
                        await server.relay_signal(device_id, target_id, signal)
                continue
            
            if msg_type == 'list_peers':
                room_id = message.get('room')
                if device_id and room_id:
                    await websocket.send(json.dumps({
                        'type': 'peer_list',
                        'room': room_id,
                        'peers': server.get_room_peers(room_id, exclude_device_id=device_id),
                    }))
                continue
            
            # Ping/keep-alive
            if msg_type == 'ping':
                await websocket.send(json.dumps({'type': 'pong'}))
                continue
    except (ConnectionClosedOK, ConnectionClosedError) as close_exc:
        print(f"[server] Connection closed cleanly for {device_id or 'unknown device'}: {close_exc}")
    except Exception as exc:
        print(f"[server] Connection handler failed: {exc}")
    finally:
        if device_id:
            device_name = server.device_info.get(device_id, {}).get('name')
            room_ids = [room_id for room_id, members in server.rooms.items() if device_id in members]
            server.unregister_device(device_id)
            for room_id in room_ids:
                await server.broadcast_peer_left(room_id, device_id, device_name or device_id)

async def main():
    port = int(os.environ.get('PORT', '8080'))
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    
    # Handle graceful shutdown
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass
    
    async with websockets.serve(handler, '0.0.0.0', port):
        print(f'✓ P2P Signaling Server listening on ws://0.0.0.0:{port}')
        try:
            await stop_event.wait()
        except asyncio.CancelledError:
            print('✱ Server shutdown requested')
        except KeyboardInterrupt:
            print('✱ KeyboardInterrupt received')
            pass

    print('✓ Signaling server shut down gracefully')

if __name__ == '__main__':
    asyncio.run(main())
