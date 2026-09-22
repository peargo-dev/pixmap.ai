from src.sql.models import User
import time

class Client:
    def __init__(self, socket, user: User, session_id: str):
        self.socket = socket
        self.ip = socket.client.host
        self.last_ping = time.time()
        self.canvas = 0
        self.subscribed_chunks: set[int] = set()
        self.is_proxy: bool = False
        self.user: User | None = user
        self.country_code = socket.headers.get("CF-IPCountry", "??") #default to ?? if header is missing
        self.session_id = session_id
        self.banned: bool = False
        self.is_nsws: bool = False

    def on_open(self):
        clients.append(self)
        clients_by_ip.setdefault(self.ip, set()).add(self)
        if self.user:
            clients_by_user.setdefault(self.user.id, set()).add(self)

    def on_close(self):
        # Precondition: socket is closed. this will delete the client object.
        from src.socket_server.chunks import unsubscribe_from_all_chunks
        try:
            unsubscribe_from_all_chunks(self)
        except Exception:
            pass

        if self in clients:
            clients.remove(self)

        ip_clients = clients_by_ip.get(self.ip)
        if ip_clients:
            ip_clients.discard(self)
            if not ip_clients:
                del clients_by_ip[self.ip]

        if self.user:
            user_clients = clients_by_user.get(self.user.id)
            if user_clients:
                user_clients.discard(self)
                if not user_clients:
                    del clients_by_user[self.user.id]

    async def safe_send_text(self, text: str):
        try:
            await self.socket.send_text(text)
        except Exception:
            self.on_close()

    async def safe_send_bytes(self, data: bytes):
        try:
            await self.socket.send_bytes(data)
        except Exception:
            self.on_close()

clients: list[Client] = []
clients_by_user: dict[int, set[Client]] = {}
clients_by_ip: dict[str, set[Client]] = {}

#i'm too lazy to have this as a set, and this will only be used for pastes/rbs, so...
def get_clients_on_canvas(canvas_id: int) -> set[Client]:
    ret = []
    for client in clients:
        if client.canvas == canvas_id:
            ret.append(client)

    return ret