# Code from https://timhanewich.medium.com/how-to-use-a-reyax-rylr998-lora-module-with-a-raspberry-pi-pico-and-other-microcontrollers-4ae52686836f
import reyax
import time
import machine

u = machine.UART(0, baudrate=115200, tx=machine.Pin(0), rx=machine.Pin(1))
lora = reyax.RYLR998(u)

if lora.pulse:
    print("LoRa module connected!")

while True:
    msg = lora.receive()
    if msg is not None:
        print("Received:", msg.data)
        
        # Save to file
        with open("received.txt", "a") as f:
            f.write(str(msg.data) + "\n")
            
        print("Saved to file!")
    
    time.sleep(0.1)