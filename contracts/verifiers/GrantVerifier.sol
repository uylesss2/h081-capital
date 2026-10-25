// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract GrantVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 12017019693850155804776661966626903625658038027663161932540092509356485998844;
    uint256 constant alphay  = 3890627203793886091738697557938730734916718218094444210478213872524560133536;
    uint256 constant betax1  = 16634438569144509046320486794661047864325709909516351894999044395552743236065;
    uint256 constant betax2  = 6547916658235308366947843829845169896925522156450766991765314287640068388015;
    uint256 constant betay1  = 12276857391198640165700878803551036504292954567401124742311971291583919679634;
    uint256 constant betay2  = 12311070576328100855945125129337469341109788993640618873616577081403324735298;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11272709844148140267402268644089718854557836040781519611073115587779316970224;
    uint256 constant deltax2 = 17665069817350348277197717107895780744100242278022252485357857244612261580356;
    uint256 constant deltay1 = 12181283141847520266547586059746932086843872605398070564902886895791177561012;
    uint256 constant deltay2 = 7810997440861566374183587266217113880374321377574349619464682012192544364341;

    
    uint256 constant IC0x = 11019194877521477865113198372346846682005827168751514837018252548289840467050;
    uint256 constant IC0y = 10901980014623385450496959571024235841229669704134743213618364474705579815215;
    
    uint256 constant IC1x = 6733318862068571346586002407619536356686835634575947633841120674468204895722;
    uint256 constant IC1y = 12787857851402919848626330875104916659126927336737802221700441938843410608921;
    
    uint256 constant IC2x = 13935646666283763699173003901557196372035333582289065964406663159882824357745;
    uint256 constant IC2y = 11157975398777808798930832924377984914239162589363543559419407699279067740482;
    
    uint256 constant IC3x = 5331174985830054423036503937069183836855338007059183430455789618989681846522;
    uint256 constant IC3y = 5369862359389960537029972933326929149006598079955449492254033088336576523303;
    
    uint256 constant IC4x = 2115230785833209988058484762409300758048271315279792073997433991115281592396;
    uint256 constant IC4y = 9513472147235896819294001560379062016638475168195315516566948241660988324099;
    
    uint256 constant IC5x = 19043388973553044046228067861158381298198370808110306459128648865772103684447;
    uint256 constant IC5y = 20202861113700230335731698014473824363969273644216810454014996117859134109275;
    
    uint256 constant IC6x = 1823013295548176200434343660405746980616649372141634129265559378993207654214;
    uint256 constant IC6y = 13905538138030412769935794881408094966460309833624730138067790974316343098345;
    
    uint256 constant IC7x = 390386548330291984481023133845676705354690495145962386910944307809601747596;
    uint256 constant IC7y = 14410375892669693697903130798208583265031046352557409782836366494773401959711;
    
    uint256 constant IC8x = 3958000654356229919974437683177852814711853461801239412220954240591135134833;
    uint256 constant IC8y = 19747401848821971661035394950216020666058308196690567474565667059993918413003;
    
    uint256 constant IC9x = 20458385475641499365322557608343981677848618459054028733808338407032058169358;
    uint256 constant IC9y = 16663845814596208923343261122063704917971437191112769715212918593977584941476;
    
    uint256 constant IC10x = 14239010689174595623337727921032234871708812943080672522470910329160801409922;
    uint256 constant IC10y = 19354860620692716297525371350904197968199290701079358412818133101179313923273;
    
    uint256 constant IC11x = 92446143605643125463069970586570487301155612646907361023559757020610579975;
    uint256 constant IC11y = 1410542778302767990932963483613889996724594990136046771842117388120332277158;
    
    uint256 constant IC12x = 10123129938030218368998012046084376252867689231734733138302825414796375048992;
    uint256 constant IC12y = 21413037214142381620690163243331035490706954737212143140518405830875123185033;
    
    uint256 constant IC13x = 19385565194571332183319095335312059887618998139907678370892857830645365600605;
    uint256 constant IC13y = 7328770264173172739676517117706526621124372615894364312896515872708664340383;
    
    uint256 constant IC14x = 16481076383639267787388591814864886805870807026131588326609501659853830178952;
    uint256 constant IC14y = 17896708353707142449531687499987049951389069044852335891830795437608659534851;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[14] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
