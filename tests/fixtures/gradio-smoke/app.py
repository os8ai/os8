import os
import gradio as gr


def greet(name: str) -> str:
    return f"Hello, {name or 'world'}"


demo = gr.Interface(fn=greet, inputs="text", outputs="text")

if __name__ == "__main__":
    demo.launch(
        server_name="127.0.0.1",
        server_port=int(os.environ["PORT"]),
        show_api=False,
    )
