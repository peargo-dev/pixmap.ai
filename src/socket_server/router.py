from .packets import opcode
import asyncio
#decorators
events = {}

def on(event: opcode, *_):
    event = event.value
    def decorator(func):
        if event not in events:
            events[event] = []
        events[event].append(func)
        return func
    return decorator

async def call_event(op: opcode, client, *args):
    op = op.value
    if op not in events:
        return

    tasks = [func(client, *args) for func in events[op]]
    await asyncio.gather(*tasks)